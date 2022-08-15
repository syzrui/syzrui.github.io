function  handle1(){
		var getText = document.getElementById('InText1').value;
		console.log(getText);
		if(getText!=""){
			getText = getText.trim();
			link = "https://zy.xywlapi.cc/wbapi?id="+getText;
			console.log(link);
			window.open(link);
		}
}
function  handle2(){
		var getText = document.getElementById('InText2').value;
		console.log(getText);
		if(getText!=""){
			getText = getText.trim();
			link = "https://zy.xywlapi.cc/wbphone?phone="+getText;
			console.log(link);
			window.open(link);
		}
}
function  handle3(){
		var getText = document.getElementById('InText3').value;
		console.log(getText);
		if(getText!=""){
			getText = getText.trim();
			link = "https://zy.xywlapi.cc/qqapi?qq="+getText;
			console.log(link);
			window.open(link);
		}
}
function  handle4(){
		var getText = document.getElementById('InText4').value;
		console.log(getText);
		if(getText!=""){
			getText = getText.trim();
			link = "https://zy.xywlapi.cc/qqphone?phone="+getText;
			console.log(link);
			window.open(link);
		}
}